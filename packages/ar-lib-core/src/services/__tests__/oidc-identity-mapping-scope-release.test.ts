import { beforeEach, describe, expect, it, vi } from 'vitest';
import type { DatabaseAdapter } from '../../db/adapter';

const { resolveBinding, executeMapping } = vi.hoisted(() => ({
  resolveBinding: vi.fn(),
  executeMapping: vi.fn(),
}));

vi.mock('../identity-mapping-runtime-resolver', () => ({
  resolveRuntimeIdentityMappingBinding: resolveBinding,
  assertRuntimeIdentityMappingReleaseSafety: vi.fn(),
}));

vi.mock('@authrim/ar-lib-field-mapping/runtime', () => ({
  executeRuntimeMapping: executeMapping,
}));

// The real Destination Profile release filter runs here: only the mapping runtime, the binding
// lookup and the database are replaced.
import { applyOIDCIdentityMapping } from '../oidc-identity-mapping';

type ProfileClaim = { claimName: string; requiredScopes?: string[]; required?: boolean };

function database(claims: ProfileClaim[]): DatabaseAdapter {
  const queryOne = vi.fn(async (sql: string) =>
    sql.includes('destination_profiles')
      ? {
          profile_id: 'destination-profile-oidc',
          destination_type: 'oidc',
          version_id: 'version-1',
          schema_json: JSON.stringify({ claims }),
        }
      : // The user's release consent: every field is agreed to, so the scopes alone decide.
        {
          id: 'consent-1',
          released_claims_json: JSON.stringify(claims.map((claim) => claim.claimName)),
          released_attributes_json: null,
          evidence_json: '{}',
          created_at: 1,
        }
  );
  return { queryOne } as unknown as DatabaseAdapter;
}

const edge = (path: string) => ({
  id: `edge-${path}`,
  sourceRef: { side: 'source', namespace: 'oidc.claim', path },
  targetRef: { side: 'destination', namespace: 'oidc.claim', path },
});

describe('identity mapping release is bound by the request scopes', () => {
  const sub = { claimName: 'sub', required: true, requiredScopes: [] };
  // The mapping reads the user's attributes (not only the claims the scopes released), so it
  // outputs email and a custom claim for any request.
  const userAttributes = { email: 'alice@example.com', department: 'Finance' };

  beforeEach(() => {
    vi.clearAllMocks();
    resolveBinding.mockResolvedValue({
      fieldMappingSetId: 'set-1',
      fieldMappingVersionId: 'version-1',
      destinationNamespace: 'oidc.claim',
      destinationProfileId: 'destination-profile-oidc',
      destinationProfileIds: ['destination-profile-oidc'],
      catalog: { entries: [] },
      edges: [edge('email'), edge('department')],
      transforms: [],
      validationRules: [],
      fieldMappingSet: {},
    });
    executeMapping.mockReturnValue({
      status: 'success',
      values: ['email', 'department'].map((path) => ({
        sourceRef: { side: 'destination', namespace: 'oidc.claim', path },
        value: userAttributes[path as keyof typeof userAttributes],
      })),
    });
  });

  const map = (
    claims: ProfileClaim[],
    grantedScopes: string[],
    surface: 'id_token' | 'userinfo' = 'id_token'
  ) =>
    applyOIDCIdentityMapping({
      adapter: database(claims),
      tenantId: 'tenant-a',
      clientId: 'client-a',
      destinationSurface: surface,
      grantedScopes,
      claims: { sub: 'user-1' },
      sourceAttributes: userAttributes,
    }).then((result) => result.claims);

  it('does not release a mapped email to a request without the email scope', async () => {
    const profile = [sub, { claimName: 'email' }, { claimName: 'department' }];
    for (const surface of ['id_token', 'userinfo'] as const) {
      await expect(map(profile, ['openid'], surface)).resolves.toEqual({
        sub: 'user-1',
        department: 'Finance',
      });
    }
  });

  it('releases it once the request carries the email scope', async () => {
    const profile = [sub, { claimName: 'email' }, { claimName: 'department' }];
    await expect(map(profile, ['openid', 'email'])).resolves.toEqual({
      sub: 'user-1',
      email: 'alice@example.com',
      department: 'Finance',
    });
  });

  it('releases it to every request when the profile field lists openid', async () => {
    const profile = [sub, { claimName: 'email', requiredScopes: ['openid'] }];
    await expect(map(profile, ['openid'])).resolves.toEqual({
      sub: 'user-1',
      email: 'alice@example.com',
    });
  });

  it('keeps a custom claim with no listed scope unscoped, as before', async () => {
    await expect(map([sub, { claimName: 'department' }], ['openid'])).resolves.toEqual({
      sub: 'user-1',
      department: 'Finance',
    });
  });

  describe('for an ID token that is the only carrier of the claims', () => {
    // The profile lists email and name for UserInfo only, as the standard template does.
    const profile = [
      sub,
      { claimName: 'email', surfaces: ['userinfo'], requiredScopes: ['email'] },
      { claimName: 'name', surfaces: ['userinfo'], requiredScopes: ['profile'] },
      { claimName: 'department', surfaces: ['userinfo'] },
    ];
    const mapWith = (
      claims: Record<string, unknown>,
      grantedScopes: string[],
      flags: { claimsAuthorizedByRequest?: boolean; userInfoClaimsInIdToken?: boolean }
    ) =>
      applyOIDCIdentityMapping({
        adapter: database(profile),
        tenantId: 'tenant-a',
        clientId: 'client-a',
        destinationSurface: 'id_token',
        grantedScopes,
        claims: { sub: 'user-1', ...claims },
        sourceAttributes: userAttributes,
        ...flags,
      }).then((result) => result.claims);

    it('releases the claims the endpoint authorized, which the mapping reads and rewrites', async () => {
      await expect(
        mapWith({ email: 'old@example.com' }, ['openid', 'email'], {
          userInfoClaimsInIdToken: true,
          claimsAuthorizedByRequest: true,
        })
      ).resolves.toEqual({
        sub: 'user-1',
        email: 'alice@example.com',
        department: 'Finance',
      });
    });

    it('does not release what the mapping adds for a scope the request did not carry', async () => {
      // email was not authorized by the endpoint (no email scope), so the mapping's own output
      // for it is held to the scopes; name was, through the claims parameter.
      await expect(
        mapWith({ name: 'Alice' }, ['openid'], {
          userInfoClaimsInIdToken: true,
          claimsAuthorizedByRequest: true,
        })
      ).resolves.toEqual({ sub: 'user-1', name: 'Alice', department: 'Finance' });
    });

    it('does not count as authorized a claim whose value the mapping replaced', async () => {
      // The caller authorized name 'Alice' (claims parameter, no profile scope); the mapping's own
      // output for the field is another value, which is held to the scopes.
      executeMapping.mockReturnValueOnce({
        status: 'success',
        values: [
          {
            sourceRef: { side: 'destination', namespace: 'oidc.claim', path: 'name' },
            value: 'Mapped Alice',
          },
        ],
      });
      resolveBinding.mockResolvedValueOnce({
        fieldMappingSetId: 'set-1',
        fieldMappingVersionId: 'version-1',
        destinationNamespace: 'oidc.claim',
        destinationProfileId: 'destination-profile-oidc',
        destinationProfileIds: ['destination-profile-oidc'],
        catalog: { entries: [] },
        edges: [edge('name')],
        transforms: [],
        validationRules: [],
        fieldMappingSet: {},
      });
      await expect(
        mapWith({ name: 'Alice' }, ['openid'], {
          userInfoClaimsInIdToken: true,
          claimsAuthorizedByRequest: true,
        })
      ).resolves.toEqual({ sub: 'user-1' });
    });

    it('treats an address with its members in another order as the value the endpoint authorized', async () => {
      const addressProfile = [sub, { claimName: 'address', requiredScopes: ['address'] }];
      const authorized = { formatted: '1-1 Chiyoda', country: 'JP' };
      executeMapping.mockReturnValueOnce({
        status: 'success',
        values: [
          {
            sourceRef: { side: 'destination', namespace: 'oidc.claim', path: 'address' },
            value: { country: 'JP', formatted: '1-1 Chiyoda' },
          },
        ],
      });
      resolveBinding.mockResolvedValueOnce({
        fieldMappingSetId: 'set-1',
        fieldMappingVersionId: 'version-1',
        destinationNamespace: 'oidc.claim',
        destinationProfileId: 'destination-profile-oidc',
        destinationProfileIds: ['destination-profile-oidc'],
        catalog: { entries: [] },
        edges: [edge('address')],
        transforms: [],
        validationRules: [],
        fieldMappingSet: {},
      });
      const result = await applyOIDCIdentityMapping({
        adapter: database(addressProfile),
        tenantId: 'tenant-a',
        clientId: 'client-a',
        destinationSurface: 'id_token',
        grantedScopes: ['openid'],
        claims: { sub: 'user-1', address: authorized },
        claimsAuthorizedByRequest: true,
      });
      expect(result.claims).toEqual({
        sub: 'user-1',
        address: { country: 'JP', formatted: '1-1 Chiyoda' },
      });
    });

    it('requires the profile’s own scope even for a claim the endpoint authorized', async () => {
      const custom = [sub, { claimName: 'email', requiredScopes: ['directory'] }];
      await expect(
        applyOIDCIdentityMapping({
          adapter: database(custom),
          tenantId: 'tenant-a',
          clientId: 'client-a',
          destinationSurface: 'id_token',
          grantedScopes: ['openid', 'email'],
          claims: { sub: 'user-1', email: 'alice@example.com' },
          claimsAuthorizedByRequest: true,
        }).then((result) => result.claims)
      ).resolves.toEqual({ sub: 'user-1' });
    });

    it('keeps the UserInfo-only fields out of an ID token that is not standing in for UserInfo', async () => {
      await expect(
        mapWith({ email: 'alice@example.com' }, ['openid', 'email'], {
          claimsAuthorizedByRequest: true,
        })
      ).resolves.toEqual({ sub: 'user-1' });
    });

    it('changes nothing for a caller that sets neither flag (the token endpoint)', async () => {
      await expect(mapWith({}, ['openid', 'email'], {})).resolves.toEqual({ sub: 'user-1' });
    });
  });
});

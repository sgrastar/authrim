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
});

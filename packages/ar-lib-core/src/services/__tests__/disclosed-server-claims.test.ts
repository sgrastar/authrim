import { beforeEach, describe, expect, it, vi } from 'vitest';

const m = vi.hoisted(() => ({ binding: vi.fn(), descriptor: vi.fn() }));

vi.mock('../identity-mapping-resolution', () => ({
  resolveOidcIdentityMappingBinding: m.binding,
}));
vi.mock('../admin-database-adapter', () => ({
  requireDedicatedAdminDatabaseAdapter: () => ({}),
}));
vi.mock('../destination-profile-consent', async (importOriginal) => ({
  ...(await importOriginal<typeof import('../destination-profile-consent')>()),
  loadDestinationProfileConsentDescriptor: m.descriptor,
}));

import { resolveDisclosedServerClaims } from '../disclosed-server-claims';

const claims = {
  authrim_roles: ['member'],
  authrim_groups: [{ id: 'g', key: 'staff', name: 'Staff', kind: 'static' }],
  email: 'not-a-server-claim',
};
const input = {
  env: {} as never,
  tenantId: 't1',
  clientId: 'app',
  surface: 'userinfo' as const,
  claims,
};

beforeEach(() => {
  vi.clearAllMocks();
  m.binding.mockResolvedValue({
    binding: { tenantId: 't1', destinationProfileId: 'p1', destinationProfileIds: ['p1'] },
  });
});

describe('resolveDisclosedServerClaims', () => {
  it('keeps only the computed claims the profile lists for the surface, as deep copies', async () => {
    m.descriptor.mockResolvedValue({
      destinationType: 'oidc',
      fields: [
        { key: 'authrim_groups', surfaces: ['userinfo'] },
        { key: 'authrim_roles', surfaces: ['id_token'] },
        { key: 'email', surfaces: [] },
      ],
    });
    const result = await resolveDisclosedServerClaims(input);
    expect(Object.keys(result)).toEqual(['authrim_groups']);
    expect(result.authrim_groups).toEqual(claims.authrim_groups);
    expect(result.authrim_groups).not.toBe(claims.authrim_groups);
    const alsoIdToken = await resolveDisclosedServerClaims({
      ...input,
      surface: 'id_token',
      alsoSurfaces: ['userinfo'],
    });
    expect(Object.keys(alsoIdToken).sort()).toEqual(['authrim_groups', 'authrim_roles']);
  });

  it('does not disclose a field whose required scope is not granted', async () => {
    m.descriptor.mockResolvedValue({
      destinationType: 'oidc',
      fields: [{ key: 'authrim_groups', surfaces: [], requiredScopes: ['groups'] }],
    });
    expect(await resolveDisclosedServerClaims({ ...input, grantedScopes: ['openid'] })).toEqual({});
    expect(
      Object.keys(await resolveDisclosedServerClaims({ ...input, grantedScopes: ['groups'] }))
    ).toEqual(['authrim_groups']);
  });

  it('discloses nothing without a profile, or when the mapping cannot be resolved', async () => {
    m.binding.mockResolvedValue({ binding: null });
    expect(await resolveDisclosedServerClaims(input)).toEqual({});
    m.binding.mockRejectedValue(new Error('unusable'));
    expect(await resolveDisclosedServerClaims(input)).toEqual({});
  });
});

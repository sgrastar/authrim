import { beforeEach, describe, expect, it, vi } from 'vitest';

const mocks = vi.hoisted(() => ({
  executeRuntimeMapping: vi.fn(),
  resolveBinding: vi.fn(),
  loadDescriptor: vi.fn(),
  filterProfile: vi.fn(),
  loadFeatureConfig: vi.fn(),
  resolveSources: vi.fn(),
  resolveFieldValues: vi.fn(),
}));

vi.mock('../custom-claims/resolver', async (importOriginal) => ({
  ...(await importOriginal<typeof import('../custom-claims/resolver')>()),
  loadFeatureConfig: mocks.loadFeatureConfig,
  createCustomClaimSchemaResolverFromSources: () => ({
    resolveFieldValues: mocks.resolveFieldValues,
  }),
}));

vi.mock('../custom-claims/runtime-sources', () => ({
  resolveCustomClaimRuntimeSourcesFromEnv: mocks.resolveSources,
}));

vi.mock('@authrim/ar-lib-field-mapping/runtime', () => ({
  executeRuntimeMapping: mocks.executeRuntimeMapping,
}));

vi.mock('../identity-mapping-runtime-resolver', async (importOriginal) => ({
  ...(await importOriginal<typeof import('../identity-mapping-runtime-resolver')>()),
  resolveRuntimeIdentityMappingBinding: mocks.resolveBinding,
}));

vi.mock('../destination-profile-consent', async (importOriginal) => ({
  ...(await importOriginal<typeof import('../destination-profile-consent')>()),
  loadResourceServerDestinationProfileDescriptor: mocks.loadDescriptor,
  filterIntrospectionClaimsByResourceServerProfile: mocks.filterProfile,
}));

import { applyIntrospectionIdentityMapping } from '../introspection-identity-mapping';

const input = {
  coreAdapter: {} as never,
  adminAdapter: {} as never,
  env: {} as never,
  tenantId: 'tenant_a',
  resourceServerId: 'payments-api',
  grantedScopes: ['employee'],
  claims: {
    active: true,
    sub: 'user_1',
    department: 'Finance',
    private_note: 'must-not-leak',
  },
};

describe('applyIntrospectionIdentityMapping', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mocks.loadDescriptor.mockResolvedValue({
      profileId: 'profile_rs',
      profileVersionId: 'profile_version_1',
      destinationType: 'resource_server',
      fields: [],
    });
    mocks.filterProfile.mockImplementation(async ({ claims }) => claims);
  });

  it('executes the active mapping and releases only destination-side mapped values', async () => {
    mocks.resolveBinding.mockResolvedValue({
      fieldMappingSetId: 'mapping_set_1',
      fieldMappingVersionId: 'mapping_version_1',
      fieldMappingSet: { id: 'mapping_set_1' },
      catalog: { id: 'catalog_1', entries: [] },
      edges: [
        {
          sourceRef: { side: 'source', namespace: 'authrim.profile', path: 'department' },
          targetRef: {
            side: 'destination',
            namespace: 'introspection.claim',
            path: 'employee_department',
          },
        },
      ],
      transforms: [],
      validationRules: [],
      destinationNamespace: 'introspection.claim',
      destinationProfileId: 'profile_rs',
      destinationProfileIds: ['profile_rs'],
    });
    mocks.executeRuntimeMapping.mockReturnValue({
      status: 'success',
      values: [
        {
          value: 'Finance',
          sourceRef: {
            side: 'destination',
            namespace: 'introspection.claim',
            path: 'employee_department',
          },
        },
        {
          value: 'ignored',
          sourceRef: { side: 'source', namespace: 'authrim.profile', path: 'department' },
        },
        {
          value: 'wrong namespace',
          sourceRef: {
            side: 'destination',
            namespace: 'oidc.claim',
            path: 'must_not_leak',
          },
        },
      ],
    });

    await applyIntrospectionIdentityMapping(input);

    expect(mocks.executeRuntimeMapping).toHaveBeenCalledWith(
      expect.objectContaining({
        sourceValues: expect.arrayContaining([
          expect.objectContaining({
            value: 'Finance',
            sourceRef: expect.objectContaining({
              namespace: 'authrim.profile',
              path: 'department',
            }),
          }),
        ]),
      })
    );
    expect(mocks.filterProfile).toHaveBeenCalledWith(
      expect.objectContaining({
        profileId: 'profile_rs',
        claims: {
          active: true,
          sub: 'user_1',
          employee_department: 'Finance',
        },
      })
    );
  });

  it('preserves authorization-server introspection claims while allowing extensions', async () => {
    mocks.resolveBinding.mockResolvedValue({
      fieldMappingSetId: 'mapping_set_1',
      fieldMappingVersionId: 'mapping_version_1',
      fieldMappingSet: { id: 'mapping_set_1' },
      catalog: { id: 'catalog_1', entries: [] },
      edges: [],
      transforms: [],
      validationRules: [],
      destinationNamespace: 'introspection.claim',
      destinationProfileId: 'profile_rs',
      destinationProfileIds: ['profile_rs'],
    });
    mocks.executeRuntimeMapping.mockReturnValue({
      status: 'success',
      values: [
        {
          value: 'admin:all',
          sourceRef: {
            side: 'destination',
            namespace: 'introspection.claim',
            path: 'scope',
          },
        },
        {
          value: 'other-client',
          sourceRef: {
            side: 'destination',
            namespace: 'introspection.claim',
            path: 'client_id',
          },
        },
        {
          value: 'Engineering',
          sourceRef: {
            side: 'destination',
            namespace: 'introspection.claim',
            path: 'department',
          },
        },
      ],
    });

    await applyIntrospectionIdentityMapping({
      ...input,
      claims: {
        ...input.claims,
        scope: 'openid profile',
        client_id: 'client-a',
      },
    });

    expect(mocks.filterProfile).toHaveBeenCalledWith(
      expect.objectContaining({
        claims: expect.objectContaining({
          scope: 'openid profile',
          client_id: 'client-a',
          department: 'Engineering',
        }),
      })
    );
  });

  it('protects introspection envelope claims with a custom destination namespace', async () => {
    mocks.resolveBinding.mockResolvedValue({
      fieldMappingSetId: 'mapping_set_1',
      fieldMappingVersionId: 'mapping_version_1',
      fieldMappingSet: { id: 'mapping_set_1' },
      catalog: { id: 'catalog_1', entries: [] },
      edges: [],
      transforms: [],
      validationRules: [],
      destinationNamespace: 'custom',
      destinationProfileId: 'profile_rs',
      destinationProfileIds: ['profile_rs'],
    });
    mocks.executeRuntimeMapping.mockReturnValue({
      status: 'success',
      values: [
        {
          value: 'admin:all',
          sourceRef: { side: 'destination', namespace: 'custom', path: 'scope' },
        },
        {
          value: 'other-client',
          sourceRef: { side: 'destination', namespace: 'custom', path: 'client_id' },
        },
        {
          value: 'pairwise-user-1',
          sourceRef: { side: 'destination', namespace: 'custom', path: 'sub' },
        },
        {
          value: 'Engineering',
          sourceRef: { side: 'destination', namespace: 'custom', path: 'department' },
        },
      ],
    });

    await applyIntrospectionIdentityMapping({
      ...input,
      claims: {
        ...input.claims,
        scope: 'openid profile',
        client_id: 'client-a',
      },
    });

    expect(mocks.filterProfile).toHaveBeenCalledWith(
      expect.objectContaining({
        claims: expect.objectContaining({
          scope: 'openid profile',
          client_id: 'client-a',
          sub: 'pairwise-user-1',
          department: 'Engineering',
        }),
      })
    );
  });

  it('rejects mappings that reference more than one Destination Profile', async () => {
    mocks.resolveBinding.mockResolvedValue({
      fieldMappingSetId: 'mapping_set_1',
      fieldMappingVersionId: 'mapping_version_1',
      fieldMappingSet: { id: 'mapping_set_1' },
      catalog: { id: 'catalog_1', entries: [] },
      edges: [],
      transforms: [],
      validationRules: [],
      destinationNamespace: 'introspection.claim',
      destinationProfileId: 'profile_rs',
      destinationProfileIds: ['profile_rs', 'profile_other'],
    });

    await expect(applyIntrospectionIdentityMapping(input)).rejects.toThrow(
      'must reference exactly one matching Destination Profile'
    );
    expect(mocks.executeRuntimeMapping).not.toHaveBeenCalled();
  });

  it('fails closed to the protocol envelope when no mapping is active', async () => {
    mocks.resolveBinding.mockResolvedValue(null);

    await applyIntrospectionIdentityMapping(input);

    expect(mocks.executeRuntimeMapping).not.toHaveBeenCalled();
    expect(mocks.filterProfile).toHaveBeenCalledWith(
      expect.objectContaining({
        claims: { active: true, sub: 'user_1' },
      })
    );
  });
});

describe('custom attributes for a pairwise subject', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mocks.loadDescriptor.mockResolvedValue({
      profileId: 'profile_rs',
      profileVersionId: 'profile_version_1',
      destinationType: 'resource_server',
      fields: [],
    });
    mocks.filterProfile.mockImplementation(async ({ claims }) => claims);
    mocks.resolveBinding.mockResolvedValue({
      fieldMappingSetId: 'mapping_set_1',
      fieldMappingVersionId: 'mapping_version_1',
      fieldMappingSet: { id: 'mapping_set_1' },
      catalog: { id: 'catalog_1', entries: [] },
      edges: [
        {
          sourceRef: { side: 'source', namespace: 'authrim.profile', path: 'employee_id' },
          targetRef: { side: 'destination', namespace: 'introspection.claim', path: 'employee' },
        },
      ],
      transforms: [],
      validationRules: [],
      destinationNamespace: 'introspection.claim',
      destinationProfileId: 'profile_rs',
      destinationProfileIds: ['profile_rs'],
    });
    mocks.executeRuntimeMapping.mockReturnValue({ status: 'success', values: [] });
    mocks.loadFeatureConfig.mockResolvedValue({ enabled: true, introspectionEnabled: true });
    mocks.resolveSources.mockResolvedValue({ schemaDb: {}, nonPiiDb: {}, piiDb: {} });
    mocks.resolveFieldValues.mockResolvedValue({ claims: { employee_id: 'E-1' } });
  });

  // A pairwise sub may equal another user's id: the attributes are read for the token's account.
  it('reads the attributes of the account the token is for, not of the public sub', async () => {
    await applyIntrospectionIdentityMapping({
      ...input,
      claims: { active: true, sub: 'user_2' },
      subjectAccountId: 'user_1',
    });

    expect(mocks.resolveSources).toHaveBeenCalledWith({}, 'tenant_a', { accountId: 'user_1' });
    expect(mocks.resolveFieldValues).toHaveBeenCalledWith('tenant_a', 'user_1', ['employee_id']);
  });

  it('reads no account attributes for a subject that is not an account', async () => {
    await applyIntrospectionIdentityMapping({
      ...input,
      claims: { active: true, sub: 'client:payments' },
      subjectAccountId: null,
    });

    expect(mocks.resolveSources).not.toHaveBeenCalled();
    expect(mocks.resolveFieldValues).not.toHaveBeenCalled();
  });
});

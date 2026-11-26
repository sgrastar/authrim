/**
 * validateSAMLSPMappingConfig: every way a Mapping Set can be refused for a SAML SP connection,
 * and the exact request made to the runtime binding resolver.
 */

import { beforeEach, describe, expect, it, vi } from 'vitest';
import { PLATFORM_MAPPING_TENANT_ID, type Env, type SAMLSPConfig } from '@authrim/ar-lib-core';

const mocks = vi.hoisted(() => ({
  owner: vi.fn(async (..._args: unknown[]): Promise<string | null> => 'tenant-a'),
  resolveBinding: vi.fn(async (..._args: unknown[]): Promise<unknown> => null),
  descriptor: vi.fn(async (..._args: unknown[]): Promise<unknown> => null),
  customEntries: vi.fn(async (..._args: unknown[]): Promise<unknown[]> => []),
  coreAdapter: { marker: 'core' },
  adminAdapter: { marker: 'admin' },
  requireAdmin: vi.fn((..._args: unknown[]): unknown => mocks.adminAdapter),
}));

vi.mock('../../mapping-set-owner', () => ({ resolveSAMLMappingSetOwner: mocks.owner }));

vi.mock('@authrim/ar-lib-core', async (importOriginal) => {
  const actual = await importOriginal<typeof import('@authrim/ar-lib-core')>();
  return {
    ...actual,
    requireAdminDatabaseAdapter: mocks.requireAdmin,
    resolveRuntimeIdentityMappingBinding: mocks.resolveBinding,
    loadDestinationProfileConsentDescriptor: mocks.descriptor,
    loadCustomClaimSchemaCatalogEntries: mocks.customEntries,
    resolveAuthCorePersistenceAdapterFromEnv: vi.fn(async () => mocks.coreAdapter),
    getLogger: () => ({
      module: () => ({ error: vi.fn(), warn: vi.fn(), info: vi.fn(), debug: vi.fn() }),
    }),
  };
});

import { validateSAMLSPMappingConfig } from '../providers';

const FIELD = 'identityMapping.fieldMappingSetId';

function config(identityMapping: Record<string, unknown> | undefined): SAMLSPConfig {
  return { entityId: 'https://sp.example.test', identityMapping } as unknown as SAMLSPConfig;
}

const goodMapping = {
  fieldMappingSetId: 'set-1',
  fieldMappingVersionId: 'version-1',
  destinationFieldPolicies: { mail: 'optional', displayName: 'optional' },
};

function goodBinding(overrides: Record<string, unknown> = {}) {
  return {
    destinationProfileId: 'profile-1',
    destinationProfileIds: ['profile-1'],
    catalog: { identity: { id: 'catalog-1' }, entries: [] },
    edges: [],
    transforms: [],
    ...overrides,
  };
}

const goodDescriptor = {
  destinationType: 'saml',
  fields: [{ key: 'mail' }, { key: 'displayName' }],
};

async function validate(mapping: Record<string, unknown> | null = goodMapping) {
  return validateSAMLSPMappingConfig({} as Env, 'tenant-a', config(mapping ?? undefined));
}

beforeEach(() => {
  vi.clearAllMocks();
  mocks.owner.mockResolvedValue('tenant-a');
  mocks.resolveBinding.mockResolvedValue(goodBinding());
  mocks.descriptor.mockResolvedValue(goodDescriptor);
  mocks.customEntries.mockResolvedValue([]);
});

describe('accepting a complete mapping', () => {
  it('returns null and resolves the binding with the exact request', async () => {
    expect(await validate()).toBeNull();

    expect(mocks.requireAdmin).toHaveBeenCalledWith({}, 'saml-sp-identity-mapping');
    expect(mocks.owner).toHaveBeenCalledWith(mocks.adminAdapter, 'tenant-a', 'set-1');
    expect(mocks.resolveBinding).toHaveBeenCalledWith(mocks.adminAdapter, {
      tenantId: 'tenant-a',
      ownerTenantId: 'tenant-a',
      normalizeCatalogEntryIds: false,
      resolveCanonicalCatalog: true,
      includeStoredProfileTargets: true,
      protocol: 'saml',
      role: 'idp',
      fieldMappingSetId: 'set-1',
      fieldMappingVersionId: 'version-1',
      partnerEntityId: 'https://sp.example.test',
    });
    expect(mocks.descriptor).toHaveBeenCalledWith(mocks.adminAdapter, 'tenant-a', 'profile-1');
  });

  it('normalises catalog entry ids only for sets owned by the platform tenant', async () => {
    mocks.owner.mockResolvedValue(PLATFORM_MAPPING_TENANT_ID);

    expect(await validate()).toBeNull();

    expect(mocks.resolveBinding.mock.calls[0]?.[1]).toMatchObject({
      ownerTenantId: PLATFORM_MAPPING_TENANT_ID,
      normalizeCatalogEntryIds: true,
    });
    expect(mocks.descriptor).toHaveBeenCalledWith(
      mocks.adminAdapter,
      PLATFORM_MAPPING_TENANT_ID,
      'profile-1'
    );
  });
});

describe('refusing an unusable mapping', () => {
  it.each([
    ['no mapping at all', null],
    ['an empty set id', { ...goodMapping, fieldMappingSetId: '' }],
  ])('refuses %s without touching the database', async (_label, mapping) => {
    expect(await validate(mapping)).toEqual({ field: FIELD });
    expect(mocks.requireAdmin).not.toHaveBeenCalled();
  });

  it('refuses a set that has no owner', async () => {
    mocks.owner.mockResolvedValue(null);

    expect(await validate()).toEqual({ field: FIELD });
    expect(mocks.resolveBinding).not.toHaveBeenCalled();
  });

  it.each([
    ['no active binding', null],
    ['a binding without a destination profile', goodBinding({ destinationProfileId: undefined })],
    ['a binding with two destination profiles', goodBinding({ destinationProfileIds: ['a', 'b'] })],
    ['a binding with no destination profiles', goodBinding({ destinationProfileIds: [] })],
  ])('refuses %s', async (_label, binding) => {
    mocks.resolveBinding.mockResolvedValue(binding);

    expect(await validate()).toEqual({ field: FIELD });
    expect(mocks.descriptor).not.toHaveBeenCalled();
  });

  it('refuses a binding that releases to a non-SAML target', async () => {
    mocks.resolveBinding.mockResolvedValue(
      goodBinding({
        storedProfileTargets: [{ side: 'destination', namespace: 'oidc.claim', path: 'x' }],
      })
    );

    expect(await validate()).toEqual({ field: FIELD });
  });

  it('refuses attribute descriptors that rename a mapped attribute', async () => {
    mocks.resolveBinding.mockResolvedValue(
      goodBinding({
        edges: [
          {
            id: 'e1',
            sourceRef: { side: 'source', namespace: 'authrim.canonical', path: 'email' },
            targetRef: { side: 'destination', namespace: 'saml.attribute', path: 'mail' },
          },
        ],
      })
    );

    expect(
      await validate({
        ...goodMapping,
        attributeDescriptors: { mail: { name: 'urn:other:name' } },
      })
    ).toEqual({ field: 'identityMapping.attributeDescriptors' });
  });

  it.each([
    ['no descriptor', null],
    ['a descriptor of another destination type', { ...goodDescriptor, destinationType: 'oidc' }],
  ])('refuses %s', async (_label, descriptor) => {
    mocks.descriptor.mockResolvedValue(descriptor);

    expect(await validate()).toEqual({ field: FIELD });
  });

  it.each([
    ['a missing field', { mail: 'optional' }],
    ['an extra field', { mail: 'optional', displayName: 'optional', extra: 'optional' }],
    ['no policies', {}],
  ])('refuses destination field policies with %s', async (_label, destinationFieldPolicies) => {
    expect(await validate({ ...goodMapping, destinationFieldPolicies })).toEqual({
      field: 'identityMapping.destinationFieldPolicies',
    });
  });

  it('refuses when anything in the resolution throws', async () => {
    mocks.resolveBinding.mockRejectedValue(new Error('db down'));

    expect(await validate()).toEqual({ field: FIELD });
  });
});

describe('virtual canonical catalogs', () => {
  it('merges the tenant custom claim entries into the catalog before judging', async () => {
    const custom = {
      id: 'custom.1',
      namespace: 'authrim.custom_claims',
      path: 'c1',
      valueType: 'string',
      cardinality: 'single',
      classification: 'pii',
      targetType: 'canonical',
    };
    mocks.customEntries.mockResolvedValue([custom]);
    mocks.resolveBinding.mockResolvedValue(
      goodBinding({
        catalog: { identity: { id: 'system_default_canonical_catalog_schema_v1' }, entries: [] },
        storedProfileTargets: [
          { side: 'destination', namespace: 'authrim.custom_claims', path: 'c1' },
        ],
      })
    );

    expect(await validate()).toBeNull();

    expect(mocks.customEntries).toHaveBeenCalledWith(mocks.coreAdapter, 'tenant-a');
  });

  it('does not load custom entries for an ordinary catalog', async () => {
    expect(await validate()).toBeNull();

    expect(mocks.customEntries).not.toHaveBeenCalled();
  });
});

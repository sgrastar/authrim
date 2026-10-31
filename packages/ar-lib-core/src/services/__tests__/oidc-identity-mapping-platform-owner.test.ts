import { beforeEach, describe, expect, it, vi } from 'vitest';
import type { DatabaseAdapter } from '../../db/adapter';

const {
  resolveBinding,
  executeMapping,
  loadDescriptor,
  assertReleaseSafety,
  loadFeatureConfig,
  resolveFieldValues,
  resolveSources,
} = vi.hoisted(() => ({
  resolveBinding: vi.fn(),
  executeMapping: vi.fn(),
  loadDescriptor: vi.fn(),
  assertReleaseSafety: vi.fn(),
  loadFeatureConfig: vi.fn(),
  resolveFieldValues: vi.fn(),
  resolveSources: vi.fn(),
}));

vi.mock('../identity-mapping-runtime-resolver', () => ({
  resolveRuntimeIdentityMappingBinding: vi.fn(),
  assertRuntimeIdentityMappingReleaseSafety: assertReleaseSafety,
}));
// The binding carries the tenant ID that owns the set; `resolveBinding` stands for the selection
// and the reading of the set (see oidc-identity-mapping-explicit-resolution.test.ts).
vi.mock('../identity-mapping-resolution', () => ({
  resolveOidcIdentityMappingBinding: async () => {
    const found = await resolveBinding();
    return {
      selection: {
        kind: 'bound',
        tier: 'tenant_default',
        setId: found.fieldMappingSetId,
        chain: [],
      },
      binding: found,
    };
  },
}));
vi.mock('@authrim/ar-lib-field-mapping/runtime', () => ({ executeRuntimeMapping: executeMapping }));
vi.mock('../destination-profile-consent', async (importOriginal) => ({
  ...(await importOriginal<typeof import('../destination-profile-consent')>()),
  filterOidcClaimsByDestinationConsent: vi.fn(
    async (input: { claims: Record<string, unknown> }) => input.claims
  ),
  loadDestinationProfileConsentDescriptor: loadDescriptor,
}));
vi.mock('../custom-claims/resolver', () => ({
  loadFeatureConfig,
  createCustomClaimSchemaResolverFromSources: vi.fn(() => ({ resolveFieldValues })),
}));
vi.mock('../custom-claims/runtime-sources', () => ({
  resolveCustomClaimRuntimeSourcesFromEnv: resolveSources,
}));

import { applyOIDCIdentityMapping } from '../oidc-identity-mapping';

const adapter = {} as DatabaseAdapter;
const adminAdapter = {
  query: vi.fn(),
  queryOne: vi.fn(),
  execute: vi.fn(),
  transaction: vi.fn(),
  batch: vi.fn(),
  isHealthy: vi.fn(),
  getType: vi.fn(),
  close: vi.fn(),
} as unknown as DatabaseAdapter;
const binding = {
  tenantId: 'tenant-a',
  fieldMappingSetId: 'set-1',
  fieldMappingVersionId: 'version-1',
  destinationNamespace: 'oidc.claim',
  destinationProfileId: 'destination-profile-oidc',
  destinationProfileIds: ['destination-profile-oidc'],
  catalog: { entries: [] },
  edges: [
    {
      id: 'edge-1',
      sourceRef: { side: 'source', namespace: 'authrim.profile', path: 'nickname' },
      targetRef: { side: 'destination', namespace: 'oidc.claim', path: 'nickname' },
    },
  ],
  transforms: [],
  validationRules: [],
  fieldMappingSet: {},
};

const base = {
  adapter,
  env: { DB_ADMIN: adminAdapter as never },
  tenantId: 'tenant-a',
  clientId: 'client-a',
  claims: { sub: 'user-1' },
  selector: { fieldMappingSetId: 'set-1' },
};

// The set is the platform's: its binding is owned by `platform`, whoever the calling tenant is.
const platformBinding = { ...binding, tenantId: 'platform' };

describe('applyOIDCIdentityMapping for a mapping the platform owns', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    resolveBinding.mockResolvedValue(platformBinding);
    executeMapping.mockReturnValue({ status: 'success', values: [] });
    loadDescriptor.mockResolvedValue({ destinationType: 'oidc', fields: [] });
    loadFeatureConfig.mockResolvedValue({ enabled: true });
    resolveSources.mockResolvedValue({});
    resolveFieldValues.mockResolvedValue({ claims: { nickname: 'tenant-field-value' } });
  });

  it('looks the Destination Profile up under the platform, not the calling tenant', async () => {
    await applyOIDCIdentityMapping(base);

    expect(loadDescriptor).toHaveBeenCalledWith(
      adminAdapter,
      'platform',
      'destination-profile-oidc'
    );
  });

  it('judges the release with every source required to be known', async () => {
    await applyOIDCIdentityMapping(base);

    expect(assertReleaseSafety).toHaveBeenCalledWith(platformBinding, [], true, {
      requireKnownSources: true,
    });
  });

  it('does not read the calling tenant’s custom fields for a key the claims lack', async () => {
    await applyOIDCIdentityMapping(base);

    expect(loadFeatureConfig).not.toHaveBeenCalled();
    expect(resolveFieldValues).not.toHaveBeenCalled();
    const sourceValues = executeMapping.mock.calls[0][0].sourceValues as Array<{ value: unknown }>;
    expect(sourceValues.map((source) => source.value)).not.toContain('tenant-field-value');
  });

  describe('and changes nothing for a mapping the tenant owns', () => {
    beforeEach(() => {
      resolveBinding.mockResolvedValue(binding);
    });

    it('looks the Destination Profile up under the calling tenant', async () => {
      await applyOIDCIdentityMapping(base);

      expect(loadDescriptor).toHaveBeenCalledWith(
        adminAdapter,
        'tenant-a',
        'destination-profile-oidc'
      );
    });

    it('does not require known sources', async () => {
      await applyOIDCIdentityMapping(base);

      expect(assertReleaseSafety).toHaveBeenCalledWith(binding, [], true);
    });

    it('still reads the tenant’s custom fields', async () => {
      await applyOIDCIdentityMapping(base);

      expect(resolveFieldValues).toHaveBeenCalledWith('tenant-a', 'user-1', ['nickname']);
    });
  });
});

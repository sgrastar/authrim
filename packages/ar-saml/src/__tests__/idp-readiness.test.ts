import { describe, expect, it, vi } from 'vitest';
import type { DatabaseAdapter, Env } from '@authrim/ar-lib-core';
import type { SAMLRuntimeImportedSPRelease } from '@authrim/ar-lib-core/types/saml-runtime-ports';
import { assertSAMLIdPProviderReadiness } from '../idp-readiness';

const TENANT_ID = 'tenant-a';
const SP = 'https://sp.example.test/saml';
const MAIL = 'urn:oid:0.9.2342.19200300.100.1.3';
const SOURCE_SELECTOR = {
  fieldMappingSetId: 'mapping-set-a',
  fieldMappingVersionId: 'mapping-version-a',
  destinationProfileId: 'destination-a',
  destinationFieldPolicies: { [MAIL]: 'required' as const },
};
const RELEASE: SAMLRuntimeImportedSPRelease = {
  tenantId: TENANT_ID,
  entityId: SP,
  sourceSelector: SOURCE_SELECTOR,
  sourceBindingRef: {
    activationId: 'activation-a',
    fieldMappingSetId: 'mapping-set-a',
    fieldMappingVersionId: 'mapping-version-a',
    mappingSnapshotHash: 'snapshot-hash-a',
    destinationProfileId: 'destination-a',
    destinationProfileVersionId: 'destination-version-a',
  },
  binding: {
    id: 'activation-a',
    role: 'idp',
    tenantId: TENANT_ID,
    localEntityId: 'https://tenant-a.example.test/saml/idp/metadata',
    partnerEntityId: SP,
    fieldMappingSetId: 'mapping-set-a',
    fieldMappingVersionId: 'mapping-version-a',
    mappingSnapshotHash: 'snapshot-hash-a',
    destinationProfileId: 'destination-a',
    destinationProfileIds: ['destination-a'],
    destinationFieldPolicies: SOURCE_SELECTOR.destinationFieldPolicies,
    catalog: {
      identity: { id: 'catalog-a', contentHash: 'catalog-hash-a' },
      entries: [
        {
          id: 'source.email',
          namespace: 'authrim.profile',
          path: 'email',
          valueType: 'string',
          cardinality: 'single',
          classification: 'pii',
          targetType: 'canonical',
        },
        {
          id: 'destination.mail',
          namespace: 'saml.attribute',
          path: MAIL,
          valueType: 'string',
          cardinality: 'single',
          classification: 'pii',
          targetType: 'destination-only',
        },
      ],
    },
    edges: [
      {
        id: 'edge-mail',
        sourceRef: {
          side: 'source',
          namespace: 'authrim.profile',
          path: 'email',
          catalogEntryId: 'source.email',
        },
        targetRef: {
          side: 'destination',
          namespace: 'saml.attribute',
          path: MAIL,
          catalogEntryId: 'destination.mail',
        },
        edgeKind: 'direct',
      },
    ],
    transforms: [],
    validationRules: [],
    fieldMappingSet: { id: 'mapping-version-a', rules: [] },
  },
  destinationProfile: {
    profileId: 'destination-a',
    profileVersionId: 'destination-version-a',
    destinationType: 'saml',
    fields: [
      {
        key: MAIL,
        label: 'mail',
        required: false,
        nullable: false,
        classification: 'pii',
        surfaces: [],
        requiredScopes: [],
        valueType: 'string',
        valueMultiplicity: 'single',
        allowedValues: [],
      },
    ],
  },
};

function environment(options: { trusted?: boolean; consent?: boolean } = {}) {
  const query = vi.fn(async (sql: string) => {
    if (!sql.includes('identity_providers')) throw new Error('unexpected query');
    return [
      {
        enabled: true,
        config_json: JSON.stringify({
          entityId: SP,
          acsUrl: 'https://sp.example.test/acs',
          identityMapping: SOURCE_SELECTOR,
          ...(options.consent ? { attributeReleaseConsent: { enabled: true, mode: 'once' } } : {}),
        }),
      },
    ];
  });
  const queryOne = vi.fn(async (sql: string) => {
    if (!sql.includes('client_trust_policies')) throw new Error('unexpected query');
    return options.trusted ? { trusted: 1, skip_authorization_consent: 0 } : null;
  });
  const core = {
    getType: () => 'postgres',
    query,
    queryOne,
    execute: vi.fn(),
    transaction: vi.fn(),
    batch: vi.fn(),
    isHealthy: vi.fn(),
    close: vi.fn(),
  } as unknown as DatabaseAdapter;
  const getKey = vi.fn(async () => ({
    kid: 'key-1',
    privateKeyPem: 'imported-private-key',
    publicKeyPem: 'imported-public-key',
    certificate: 'imported-certificate',
  }));
  const env = {
    ISSUER_URL: 'https://tenant-a.example.test',
    RUNTIME_DATA_PORTS: {
      resolveTenant: async (tenantId: string) => ({
        runtimeKind: 'portable',
        tenantId,
        coreDb: core,
        route: { allocationScope: 'shared_pool' },
      }),
    },
    SAML_RUNTIME_PORTS: {
      serviceProviders: {
        isAllowed: ({ tenantId, entityId }: { tenantId: string; entityId: string }) =>
          tenantId === TENANT_ID && entityId === SP,
        getRelease: ({ tenantId, entityId }: { tenantId: string; entityId: string }) =>
          tenantId === TENANT_ID && entityId === SP ? RELEASE : null,
      },
      signing: { getKey },
    },
  } as unknown as Env;
  return { env, query, queryOne, getKey };
}

describe('limited IdP provider readiness', () => {
  it('accepts an imported, trusted SP with an available signing key', async () => {
    const fixture = environment({ trusted: true });
    await expect(
      assertSAMLIdPProviderReadiness({ env: fixture.env, tenantId: TENANT_ID, spEntityIds: [SP] })
    ).resolves.toBeUndefined();
    expect(fixture.queryOne).toHaveBeenCalledWith(
      expect.stringContaining('client_trust_policies'),
      [TENANT_ID, SP]
    );
    expect(fixture.getKey).toHaveBeenCalled();
  });

  it('rejects an untrusted SP before a missing consent table can disable consent', async () => {
    const fixture = environment();
    await expect(
      assertSAMLIdPProviderReadiness({ env: fixture.env, tenantId: TENANT_ID, spEntityIds: [SP] })
    ).rejects.toThrow('saml_idp_runtime_consent_policy_unsupported');
  });

  it('rejects a SP that requires a consent screen the runtime does not serve', async () => {
    const fixture = environment({ trusted: true, consent: true });
    await expect(
      assertSAMLIdPProviderReadiness({ env: fixture.env, tenantId: TENANT_ID, spEntityIds: [SP] })
    ).rejects.toThrow('saml_idp_runtime_provider_policy_unsupported');
    expect(fixture.queryOne).not.toHaveBeenCalled();
  });
});

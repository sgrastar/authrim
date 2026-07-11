import type { Env, SAMLSigningKeyPolicy } from '@authrim/ar-lib-core';
import { beforeEach, describe, expect, it, vi } from 'vitest';

const { mockGetSAMLPublicSettings, mockGetSAMLLocalEntityIds, mockGetSAMLSigningMaterial } =
  vi.hoisted(() => ({
    mockGetSAMLPublicSettings: vi.fn(),
    mockGetSAMLLocalEntityIds: vi.fn(),
    mockGetSAMLSigningMaterial: vi.fn(),
  }));

vi.mock('../entity-id', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../entity-id')>();
  return {
    ...actual,
    getSAMLPublicSettings: mockGetSAMLPublicSettings,
    getSAMLLocalEntityIds: mockGetSAMLLocalEntityIds,
  };
});

vi.mock('../saml-signing-keys', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../saml-signing-keys')>();
  return {
    ...actual,
    getSAMLSigningMaterial: mockGetSAMLSigningMaterial,
  };
});

import { getSAMLIdPSigningMaterial, resolveSAMLIdPMessageSigningPolicy } from '../idp-signing';

const restoredPolicy: SAMLSigningKeyPolicy = {
  active: {
    slot: 'active',
    keyRef: 'tenant:default:saml:idp:restored-signing',
    kid: 'restored-kid',
  },
  metadataCertificatePublication: 'active_only',
};

describe('IdP message signing', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mockGetSAMLPublicSettings.mockResolvedValue({
      entityIdStyle: 'metadata_url',
      interactiveLoginUrlPolicy: 'tenant_host',
      certificateSubject: {
        countryName: 'JP',
        stateOrProvinceName: 'Tokyo',
        localityName: 'Shinagawa',
        organizationName: 'Authrim',
        organizationalUnitName: '',
        commonName: 'conformance.authrim.com',
      },
      certificateSubjectAlternativeNames: {
        includeGeneratedDnsNames: true,
        dnsNames: [],
      },
      signingKeyPolicies: { idp: restoredPolicy },
    });
    mockGetSAMLLocalEntityIds.mockResolvedValue({
      issuerUrl: 'https://conformance.authrim.com',
      entityIdStyle: 'metadata_url',
      idpEntityId: 'https://conformance.authrim.com/saml/idp/metadata',
      spEntityId: 'https://conformance.authrim.com/saml/sp/metadata',
      idpMetadataUrl: 'https://conformance.authrim.com/saml/idp/metadata',
      spMetadataUrl: 'https://conformance.authrim.com/saml/sp/metadata',
    });
    mockGetSAMLSigningMaterial.mockResolvedValue({
      keyRef: restoredPolicy.active!.keyRef,
      kid: restoredPolicy.active!.kid,
      privateKeyPem: 'restored-private-key',
      certificate: 'restored-certificate',
    });
  });

  it('uses the DR-restored tenant IdP policy when the SP has no signing override', async () => {
    await expect(
      getSAMLIdPSigningMaterial({} as Env, {
        tenantId: 'default',
        counterpartyEntityId: 'https://sp.example.test/shibboleth',
      })
    ).resolves.toMatchObject({ kid: 'restored-kid' });

    expect(mockGetSAMLSigningMaterial).toHaveBeenCalledWith(
      expect.anything(),
      expect.objectContaining({
        tenantId: 'default',
        role: 'idp',
        counterpartyEntityId: 'https://sp.example.test/shibboleth',
        policy: restoredPolicy,
        certificateSubject: expect.objectContaining({
          commonName: 'conformance.authrim.com',
        }),
        certificateSubjectAlternativeNames: {
          dnsNames: ['conformance.authrim.com'],
        },
      })
    );
  });

  it('treats an empty legacy SP policy as no override', () => {
    expect(resolveSAMLIdPMessageSigningPolicy({}, restoredPolicy)).toBe(restoredPolicy);
  });

  it('preserves an explicitly configured provider-scoped signing key', () => {
    const providerPolicy: SAMLSigningKeyPolicy = { scope: 'provider' };
    expect(resolveSAMLIdPMessageSigningPolicy(providerPolicy, restoredPolicy)).toBe(providerPolicy);
  });
});

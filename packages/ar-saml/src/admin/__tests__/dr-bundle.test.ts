import type { SAMLSPConfig } from '@authrim/ar-lib-core';
import { findDRBundlePrivateMaterial } from '@authrim/ar-lib-core';
import { describe, expect, it } from 'vitest';
import { NAMEID_FORMATS, SIGNATURE_ALGORITHMS, DIGEST_ALGORITHMS } from '../../common/constants';
import { buildSAMLDRBundle } from '../dr-bundle';

describe('buildSAMLDRBundle', () => {
  it('builds a SAML DR bundle without private key material or transient state', () => {
    const bundle = buildSAMLDRBundle({
      bundleId: 'drb_123',
      tenantId: 'library-a',
      issuer: 'https://library-a.example.org',
      generatedAt: 1770000000000,
      authrimVersion: '0.1.10',
      idpEntityId: 'https://library-a.example.org/saml/idp',
      idpSsoUrl: 'https://library-a.example.org/saml/idp/sso',
      idpSloUrl: 'https://library-a.example.org/saml/idp/slo',
      idpSigningCertificates: [
        {
          slot: 'active',
          keyRef: 'tenant:library-a:saml:idp:signing',
          kid: 'key-active',
          certificate: '-----BEGIN CERTIFICATE-----\nPUBLIC\n-----END CERTIFICATE-----',
        },
        {
          slot: 'backup',
          keyRef: 'tenant:library-a:saml:idp:backup:signing',
          kid: 'key-backup',
          certificate: '-----BEGIN CERTIFICATE-----\nBACKUP\n-----END CERTIFICATE-----',
        },
      ],
      serviceProviders: [spConfig()],
    });

    expect(bundle.kind).toBe('authrim.dr_bundle.v1');
    expect(bundle.protocols.saml?.idp.signingKeys).toEqual([
      {
        slot: 'active',
        keyRef: 'tenant:library-a:saml:idp:signing',
        kid: 'key-active',
        certificate: '-----BEGIN CERTIFICATE-----\nPUBLIC\n-----END CERTIFICATE-----',
        intendedUse: 'saml_signing',
      },
      {
        slot: 'backup',
        keyRef: 'tenant:library-a:saml:idp:backup:signing',
        kid: 'key-backup',
        certificate: '-----BEGIN CERTIFICATE-----\nBACKUP\n-----END CERTIFICATE-----',
        intendedUse: 'saml_signing',
      },
    ]);
    expect(bundle.protocols.saml?.serviceProviders[0]).toMatchObject({
      entityId: 'https://publisher.example.test/saml/sp',
      acsUrl: 'https://publisher.example.test/saml/acs',
      sloResponseUrl: 'https://publisher.example.test/saml/slo/response',
      sloBinding: 'redirect',
      authnRequestSignaturePolicy: 'required',
      logoutResponseBinding: 'post',
    });
    expect(bundle.protocols.saml?.pairwiseSubject).toMatchObject({
      secretRef: 'tenant:library-a:saml:pairwise-nameid',
      includesSecretValue: false,
    });
    expect(bundle.protocols.saml?.excludedState).toEqual({
      transientNameIdMappings: true,
      authnRequests: true,
      logoutRequests: true,
    });
    expect(findDRBundlePrivateMaterial(bundle)).toEqual([]);
  });

  it('rejects signing certificate inputs that accidentally contain private material', () => {
    expect(() =>
      buildSAMLDRBundle({
        bundleId: 'drb_unsafe',
        tenantId: 'library-a',
        issuer: 'https://library-a.example.org',
        generatedAt: 1770000000000,
        idpEntityId: 'https://library-a.example.org/saml/idp',
        idpSsoUrl: 'https://library-a.example.org/saml/idp/sso',
        idpSigningCertificates: [
          {
            slot: 'active',
            certificate: '-----BEGIN PRIVATE KEY-----\nSECRET\n-----END PRIVATE KEY-----',
          },
        ],
        serviceProviders: [spConfig()],
      })
    ).toThrow('DR bundle contains private material');
  });
});

function spConfig(): SAMLSPConfig {
  return {
    entityId: 'https://publisher.example.test/saml/sp',
    acsUrl: 'https://publisher.example.test/saml/acs',
    acsUrls: ['https://publisher.example.test/saml/acs'],
    sloUrl: 'https://publisher.example.test/saml/slo',
    sloResponseUrl: 'https://publisher.example.test/saml/slo/response',
    sloBinding: 'redirect',
    certificate: '-----BEGIN CERTIFICATE-----\nSPCERT\n-----END CERTIFICATE-----',
    authnRequestSignaturePolicy: 'required',
    logoutResponseBinding: 'post',
    acceptedAuthnRequestSignatureAlgorithms: [SIGNATURE_ALGORITHMS.RSA_SHA256],
    acceptedAuthnRequestDigestAlgorithms: [DIGEST_ALGORITHMS.SHA256],
    nameIdFormat: NAMEID_FORMATS.PERSISTENT,
    attributeMapping: {},
    attributeReleasePolicy: {
      attributes: [
        {
          name: 'urn:oid:0.9.2342.19200300.100.1.3',
          friendlyName: 'mail',
          source: 'claim',
          claim: 'email',
          required: true,
        },
      ],
    },
    signAssertions: true,
    signResponses: true,
    allowedBindings: ['post'],
  };
}
